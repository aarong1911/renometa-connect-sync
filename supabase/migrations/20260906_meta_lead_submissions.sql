-- 20260906_meta_lead_submissions.sql
--
-- Meta Ads Phase 1B / Step 1 — durable, idempotent storage for Meta Lead
-- Ads (Instant Forms) webhook submissions + CRM attribution. Does NOT
-- touch 20260904_meta_schema_baseline.sql or 20260905_meta_oauth_nonces.sql
-- (both historical/applied) — this is purely additive, a brand-new table.
--
-- Verified: no CREATE TABLE for `meta_lead_submissions` anywhere in
-- supabase/migrations/ and no existing store/function references it —
-- CREATE TABLE IF NOT EXISTS is safe here per the database-migrations
-- skill's "confirmed new" bar.
--
-- ── Why a dedicated table instead of writing straight into leads/contacts
-- ────────────────────────────────────────────────────────────────────────
-- Same rationale as google_ads_lead_submissions
-- (20260901_google_ads_lead_ingestion.sql): a Meta lead carries far more
-- provider-specific detail (leadgen ID, page/form/campaign/ad-set/ad
-- attribution, raw Instant Forms field_data) than leads/contacts have
-- columns for, and this table is also the atomic idempotency anchor that
-- prevents a replayed/retried webhook delivery from creating a duplicate
-- CRM lead.
--
-- ── Column naming: org_id, not organization_id ──────────────────────────
-- google_ads_lead_submissions uses `organization_id` (matching Google
-- Ads' own convention). This table uses `org_id` instead, matching the
-- rest of the Meta feature's own established convention
-- (meta_connections, sms_meta_messages, meta_oauth_nonces — see
-- 20260904_meta_schema_baseline.sql and 20260905_meta_oauth_nonces.sql,
-- both of which document this exact same choice) — consistent with the
-- feature it belongs to, not a different feature's convention.
--
-- ── FK conventions ───────────────────────────────────────────────────────
-- lead_id/contact_id reference public.leads(id)/public.contacts(id) with
-- on delete set null — matches the existing repo-wide convention
-- (20260808_project_creation_enhancements.sql,
-- 20260815_project_change_orders.sql, and google_ads_lead_submissions
-- itself) — NOT a `crm_`-prefixed name. If the linked lead/contact is
-- later deleted, this row (the provider-side event record) still stays as
-- historical/idempotency truth.
--
-- ── Idempotency key: UNIQUE (org_id, meta_lead_id) ──────────────────────
-- Meta documents a leadgen ID as a single, immutable identifier for one
-- lead submission event, globally issued by Meta (not scoped to a Page or
-- form) — this was NOT independently re-verified against a live API
-- response in this session (no live Meta call was made while building
-- this migration). Org-scoping the uniqueness constraint (rather than a
-- bare `unique (meta_lead_id)`) is defensive tenancy protection, mirroring
-- the same precedent already used for google_ads_lead_submissions'
-- (organization_id, google_ads_customer_id, google_submission_id)
-- constraint — never solely trusting a provider ID's own uniqueness
-- guarantee without an org boundary backstop. page_id is deliberately NOT
-- part of this constraint: a given meta_lead_id is issued for exactly one
-- Page's form, so including page_id would add no real protection, only
-- complexity. email/phone/name/form_id are never used for idempotency,
-- per the task's explicit instruction — only the provider's own immutable
-- event ID.
--
-- This table can carry lead PII (raw_field_data, normalized_email/phone/
-- name/company/city/state/zip) even before any CRM match/creation
-- happens — same server-only posture as google_ads_lead_submissions and
-- meta_oauth_nonces: RLS enabled, ZERO client-facing policies,
-- service-role-only (the ingestion function is the only thing that ever
-- reads or writes this table). NOT the same posture as meta_connections,
-- which has real client-facing policies live (meta_connections_org,
-- meta_connections_select_own_org) — meta_connections must never be cited
-- as a zero-policy precedent. The CRM/UI must consume normalized
-- Contacts/Leads, never this table directly.

create table if not exists meta_lead_submissions (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id) on delete cascade,

  -- Provider identity — meta_lead_id is Meta's own immutable ID for this
  -- exact submission (the leadgen webhook's `leadgen_id` / the retrieved
  -- lead object's `id`), the sole basis for dedupe/idempotency below.
  -- Timestamps are never used for dedupe.
  meta_lead_id            text not null,
  page_id                 text not null,
  form_id                 text,
  ad_id                   text,
  adset_id                text,
  campaign_id             text,

  -- Display-only attribution metadata (Part M — IDs above are
  -- authoritative; these are never used to resolve or override an ID).
  -- form_name is nullable and intentionally left unpopulated by Step 1's
  -- webhook path (fetching it would require a separate
  -- /{form_id}?fields=name call per lead — avoided to keep the webhook
  -- path free of N+1 Graph calls; left for a future reconciliation-time
  -- enrichment pass).
  campaign_name           text,
  adset_name              text,
  ad_name                 text,
  form_name               text,
  platform                text,

  created_time            timestamptz,

  -- Raw payload — every field_data entry Meta returned, preserved
  -- verbatim even for fields not individually normalized below (Part J:
  -- "do not discard custom questions"). Service-role-only access (see RLS
  -- below) is what makes storing this justified/safe (Part X).
  raw_field_data          jsonb not null default '[]'::jsonb,

  -- Normalized standard fields (see
  -- netlify/functions/lib/meta-lead-normalization.ts). normalized_phone is
  -- stored in this app's DISPLAY format ("(XXX) XXX-XXXX", matching
  -- src/lib/phone.ts's formatUsPhone — the same format manual/CSV contact
  -- creation already writes to contacts.phone) rather than E.164, a
  -- deliberate departure from google_ads_lead_submissions' own
  -- normalized_phone convention — see the Step 1 report for why (this
  -- codebase does not store phone numbers in one consistent format;
  -- src/lib/identity-normalization.ts's own Phase 9 audit documents this).
  -- Not every lead form asks for every field, so all are nullable.
  normalized_email        text,
  normalized_phone        text,
  normalized_first_name   text,
  normalized_last_name    text,
  normalized_full_name    text,
  normalized_company      text,
  normalized_city         text,
  normalized_state        text,
  normalized_zip          text,

  -- Every field_data entry NOT recognized as a standard field above,
  -- keyed by Meta's own field name, values preserved as arrays (never
  -- lossily joined — Part J: a field may legitimately carry multiple
  -- selected values).
  custom_fields           jsonb not null default '{}'::jsonb,

  -- CRM linkage — set once ingestion resolves a matching or newly-created
  -- CRM record.
  lead_id                 uuid references public.leads(id) on delete set null,
  contact_id              uuid references public.contacts(id) on delete set null,

  ingestion_status        text not null default 'pending'
    check (ingestion_status in ('pending', 'matched', 'created', 'failed')),
  ingestion_error         text,

  processed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (org_id, meta_lead_id)
);

comment on table meta_lead_submissions is
  'Raw Meta Lead Ads (Instant Forms) webhook submission + attribution data, one row per Meta leadgen_id (idempotent via the org/meta_lead_id unique constraint). Links to leads/contacts once CRM dedupe/creation resolves. Server-only — no client access; the CRM/UI must consume normalized Contacts/Leads, never this table directly.';

create index if not exists idx_meta_lead_submissions_org_id       on meta_lead_submissions(org_id);
create index if not exists idx_meta_lead_submissions_lead_id      on meta_lead_submissions(lead_id) where lead_id is not null;
create index if not exists idx_meta_lead_submissions_contact_id   on meta_lead_submissions(contact_id) where contact_id is not null;
create index if not exists idx_meta_lead_submissions_created_time on meta_lead_submissions(org_id, created_time);
create index if not exists idx_meta_lead_submissions_page_id      on meta_lead_submissions(page_id);

-- Reuses the shared handle_updated_at() function established in
-- 20260904_meta_schema_baseline.sql for meta_connections (rather than
-- defining a dedicated per-table function, the google_ads_lead_submissions
-- precedent) — but does NOT assume that migration has already been applied
-- in every target database: guarded with the same to_regprocedure()
-- existence check that migration uses, so this file is self-sufficient
-- regardless of apply order. A true no-op if the function already exists
-- (the common case, since 20260904 is expected to already be applied).
do $$
begin
  if to_regprocedure('public.handle_updated_at()') is null then
    execute $fn$
      create function public.handle_updated_at()
      returns trigger
      language plpgsql
      set search_path = public, pg_temp
      as $body$
      begin
        new.updated_at = now();
        return new;
      end;
      $body$
    $fn$;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.meta_lead_submissions'::regclass
      and tgname = 'meta_lead_submissions_set_updated_at'
  ) then
    create trigger meta_lead_submissions_set_updated_at
      before update on public.meta_lead_submissions
      for each row execute function public.handle_updated_at();
  end if;
end $$;

alter table meta_lead_submissions enable row level security;
-- Intentionally zero policies — service-role-only, same posture as
-- google_ads_lead_submissions and meta_oauth_nonces (see header comment
-- above for why this table specifically needs it: it can carry lead PII
-- before any CRM match exists). meta_connections is NOT part of this
-- precedent — it has real client-facing policies live
-- (meta_connections_org, meta_connections_select_own_org).

-- ── Verification (run manually — read-only) ─────────────────────────────
--
-- A. Table + columns:
--
-- select column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'meta_lead_submissions'
-- order by ordinal_position;
--
-- B. Constraints (PK / FK / UNIQUE / CHECK):
--
-- select conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.meta_lead_submissions'::regclass
-- order by conname;
--
-- Expect: meta_lead_submissions_pkey (p), meta_lead_submissions_org_id_fkey
-- (f, -> organizations), meta_lead_submissions_lead_id_fkey (f, -> leads),
-- meta_lead_submissions_contact_id_fkey (f, -> contacts),
-- meta_lead_submissions_org_id_meta_lead_id_key (u, on (org_id,
-- meta_lead_id)), meta_lead_submissions_ingestion_status_check (c).
--
-- C. Indexes:
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'meta_lead_submissions'
-- order by indexname;
--
-- D. RLS enabled (expect 1 row, relrowsecurity = true):
--
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname = 'meta_lead_submissions';
--
-- E. Policies (expect 0 rows — service-role-only by design):
--
-- select policyname from pg_policies
-- where schemaname = 'public' and tablename = 'meta_lead_submissions';
--
-- F. Trigger present (expect 1 row):
--
-- select tgname from pg_trigger
-- where tgrelid = 'public.meta_lead_submissions'::regclass
--   and not tgisinternal;
