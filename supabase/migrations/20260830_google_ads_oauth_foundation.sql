-- 20260830_google_ads_oauth_foundation.sql
--
-- Foundation for the Google Ads OAuth connection (google-ads-oauth-start.ts
-- + google-ads-oauth-callback.ts). Both tables are brand new — Google Ads
-- has no prior table in this repo (verified: no CREATE TABLE for either
-- name anywhere in supabase/migrations/, and neither is referenced by any
-- existing store/function). `CREATE TABLE IF NOT EXISTS` is therefore safe
-- here per the database-migrations skill's "confirmed new" bar — this is
-- not being used to sidestep a live-schema audit.
--
-- Two tables:
--   1. google_ads_oauth_nonces — single-use replay guard for the signed
--      OAuth `state` nonce (see lib/google-ads-oauth-state.ts). Stores only
--      a SHA-256 hash of the nonce, never the raw value.
--   2. google_ads_connections  — the persisted, encrypted Google Ads
--      connection per organization (mirrors the "dedicated per-provider
--      table" precedent set by meta_connections rather than overloading
--      the generic `integrations` table, which has no typed columns for
--      accessible/selected/login customer IDs or granted scopes).
--
-- Both are service-role-only, following the exact RLS-enabled/no-policies
-- precedent already used for agent_action_idempotency (see
-- 20260731_agentic_foundation.sql): RLS is enabled with zero policies,
-- which default-denies anon/authenticated entirely while the service-role
-- client (used exclusively by the Netlify functions that touch these
-- tables) bypasses RLS as usual. Never grant a client-facing SELECT policy
-- on google_ads_connections — it holds an encrypted refresh token.

-- ── google_ads_oauth_nonces ────────────────────────────────────────────────
-- Atomic single-use enforcement: the callback INSERTs the nonce hash BEFORE
-- exchanging the authorization code. The primary-key uniqueness constraint
-- is what makes a replayed callback (same nonce twice) fail — this is a
-- write-time atomic decision by the database, not a read-then-write check
-- in application code, so it can't race with a concurrent duplicate.
create table if not exists google_ads_oauth_nonces (
  nonce_hash text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table google_ads_oauth_nonces is
  'Single-use replay guard for signed Google Ads OAuth state nonces. Stores a SHA-256 hash only, never the raw nonce. Server-only — no client access. Rows past expires_at are safe to delete via routine cleanup (no scheduler implemented yet — see google-ads-oauth-callback.ts).';

create index if not exists idx_google_ads_oauth_nonces_expires_at on google_ads_oauth_nonces(expires_at);

alter table google_ads_oauth_nonces enable row level security;
-- Intentionally zero policies — default-deny for anon/authenticated;
-- service-role client bypasses RLS as usual.

-- ── google_ads_connections ─────────────────────────────────────────────────
-- One row per organization (unique org_id) — the architecture does not
-- support multiple simultaneous Google Ads connections per org.
create table if not exists google_ads_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  connected_by_user_id uuid references profiles(id) on delete set null,
  provider text not null default 'google_ads',
  status text not null default 'needs_account_sync'
    check (status in ('connected', 'needs_account_selection', 'needs_account_sync', 'error', 'disconnected')),
  -- AES-256-GCM, same bytea wire format as integrations.refresh_token_encrypted
  -- (see netlify/functions/lib/gmail-token-crypto.ts) — reused as-is rather
  -- than inventing a second encryption format for this provider.
  --
  -- NOT NULL by design: google-ads-oauth-callback.ts resolves an EFFECTIVE
  -- encrypted refresh token before every write (new value if Google issued
  -- one this run, else the existing encrypted value reused verbatim) and
  -- fails safely with a token_exchange redirect BEFORE writing anything if
  -- neither exists — so no insert/update path in the callback can ever
  -- reach the database with a null token. This constraint makes that
  -- invariant enforceable at the schema level, not just by convention in
  -- application code.
  encrypted_refresh_token bytea not null,
  granted_scopes text[] not null default '{}',
  token_type text,
  access_token_expires_at timestamptz,
  -- Digit-only Google Ads customer IDs (no hyphens). accessible_customer_ids
  -- is the full discovered set (managers + advertisers); selected_customer_id
  -- is the one advertiser account the org has chosen to use; login_customer_id
  -- is the manager ID to send as the login-customer-id header when acting on
  -- behalf of selected_customer_id — kept distinct from selected_customer_id
  -- since a manager account is never itself the thing being advertised from.
  accessible_customer_ids jsonb not null default '[]'::jsonb,
  selected_customer_id text,
  login_customer_id text,
  last_synced_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

comment on table google_ads_connections is
  'One Google Ads OAuth connection per organization. encrypted_refresh_token is AES-256-GCM bytea (see gmail-token-crypto.ts). Access tokens are never persisted — they are only used transiently during the OAuth callback and any future sync call. Server-only — no client access; read via a dedicated status-check function (not yet built) the same way meta-connection-status.ts fronts meta_connections.';

create index if not exists idx_google_ads_connections_organization_id on google_ads_connections(organization_id);

create or replace function public.set_google_ads_connections_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists google_ads_connections_set_updated_at on public.google_ads_connections;
create trigger google_ads_connections_set_updated_at
  before update on public.google_ads_connections
  for each row execute function public.set_google_ads_connections_updated_at();

alter table google_ads_connections enable row level security;
-- Intentionally zero policies — see comment above. This table stores an
-- encrypted refresh token; even a read-only client policy is deliberately
-- withheld until a dedicated status-check function (server-side, returning
-- only safe non-secret fields) exists to front it.

-- ── Verification (run after applying) ──────────────────────────────────────
-- select table_name from information_schema.tables
--   where table_name in ('google_ads_oauth_nonces', 'google_ads_connections');
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'google_ads_connections' order by ordinal_position;
--   -- expect encrypted_refresh_token: data_type=bytea, is_nullable=NO
--
-- -- RLS enabled — expect 2 rows, both relrowsecurity = true. Joined against
-- -- pg_namespace and filtered to the public schema explicitly so this can
-- -- never match a same-named relation living in another schema.
-- select
--   c.relname,
--   c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in (
--     'google_ads_oauth_nonces',
--     'google_ads_connections'
--   );
--
-- -- Zero client-facing policies — expect 0 rows.
-- select policyname
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'google_ads_oauth_nonces',
--     'google_ads_connections'
--   );
