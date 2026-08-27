-- 20260905_meta_oauth_nonces.sql
--
-- Meta Ads Phase 1A / Step 1 — Part B: single-use replay protection for
-- Meta OAuth, on top of the existing HMAC-signed `state` (which proves
-- authenticity/no-tampering/TTL but not single-use — see
-- meta-oauth-start.ts / meta-oauth-callback.ts). Conceptually mirrors
-- google_ads_oauth_nonces (supabase/migrations/20260830_google_ads_oauth_foundation.sql)
-- with one deliberate structural difference explained below.
--
-- NOT APPLIED. Create only — the user applies this manually via the
-- Supabase SQL Editor after review, same as every other migration in this
-- engagement.
--
-- ── Column naming choice: org_id, not organization_id ───────────────────
-- google_ads_oauth_nonces uses `organization_id` (matching
-- google_ads_connections' own convention). This table intentionally uses
-- `org_id` instead, matching meta_connections/sms_meta_messages/contacts —
-- every other table this Meta OAuth flow already touches. This is a new
-- table scoped entirely to the Meta feature, referenced only by Meta OAuth
-- code that already speaks `org_id` throughout (meta_connections.org_id,
-- resolveOrgFromBearerToken's `orgId` field); matching the feature's own
-- established convention over a different feature's (Google Ads)
-- convention is the more consistent choice here, not an oversight.
--
-- ── user_id FK target: auth.users(id), not profiles(id) ─────────────────
-- google_ads_oauth_nonces.user_id references profiles(id).
-- meta_connections.user_id references auth.users(id) (confirmed live
-- schema, see 20260904_meta_schema_baseline.sql). This table binds to the
-- exact same Meta OAuth flow that writes meta_connections.user_id, so it
-- matches that table's FK target rather than Google Ads'.
--
-- ── Structural difference from google_ads_oauth_nonces: reserve-then-
-- consume, not insert-as-consume ────────────────────────────────────────
-- google_ads_oauth_nonces is INSERTed only at callback time — the INSERT's
-- own unique-constraint violation IS the replay signal (no separate
-- "reserved but unconsumed" state ever exists). This table is INSERTed at
-- OAUTH-START time (nonce reserved, bound to org/user/product, consumed_at
-- NULL) and CONSUMED at callback time via a conditional, race-safe UPDATE
-- (consumed_at set only WHEN it was still NULL, org/user/product still
-- match, and expires_at hasn't passed). This lets the callback verify the
-- nonce was minted for the SAME org/user/product it's now being redeemed
-- for as a single atomic DB condition, rather than only checking those
-- facts against the (signed, but only self-asserted) state payload.
--
-- Only a SHA-256 hash of the nonce is ever stored — never the raw value.

create table if not exists meta_oauth_nonces (
  nonce_hash    text primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  product       text not null,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

comment on table meta_oauth_nonces is
  'Single-use replay guard for signed Meta OAuth state nonces. Stores a SHA-256 hash only, never the raw nonce. Reserved (inserted, consumed_at NULL) at meta-oauth-start.ts, consumed via a conditional UPDATE at meta-oauth-callback.ts — see file header for why this differs structurally from google_ads_oauth_nonces. Server-only — no client access.';

-- Supports the callback's cleanup-adjacent lookups and any future
-- scheduled cleanup of expired rows (no scheduler implemented yet, same as
-- google_ads_oauth_nonces).
create index if not exists idx_meta_oauth_nonces_expires_at on meta_oauth_nonces(expires_at);

alter table meta_oauth_nonces enable row level security;
-- Intentionally zero policies — default-denies anon/authenticated
-- entirely; the service-role client (meta-oauth-start.ts /
-- meta-oauth-callback.ts, the only things that ever touch this table)
-- bypasses RLS as usual. There is no legitimate client-facing use case for
-- this table, ever — never add a policy without a deliberate, reviewed
-- reason.

-- ── Verification (run manually — read-only) ─────────────────────────────
--
-- A. Table + columns:
--
-- select column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'meta_oauth_nonces'
-- order by ordinal_position;
--
-- B. PK / unique constraint (expect meta_oauth_nonces_pkey, PRIMARY KEY on nonce_hash):
--
-- select conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.meta_oauth_nonces'::regclass
-- order by conname;
--
-- C. RLS enabled (expect 1 row, relrowsecurity = true):
--
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname = 'meta_oauth_nonces';
--
-- D. Policies (expect 0 rows — service-role-only by design):
--
-- select policyname from pg_policies
-- where schemaname = 'public' and tablename = 'meta_oauth_nonces';
--
-- E. Indexes (expect meta_oauth_nonces_pkey + idx_meta_oauth_nonces_expires_at):
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'meta_oauth_nonces';
--
-- F. Expiry/consumed fields present and nullable as expected:
--
-- select column_name, is_nullable from information_schema.columns
-- where table_schema = 'public' and table_name = 'meta_oauth_nonces'
--   and column_name in ('expires_at', 'consumed_at');
-- -- expect expires_at: is_nullable = NO; consumed_at: is_nullable = YES
